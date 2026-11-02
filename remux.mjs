// Progressive MP4 (cenc-aes-ctr) -> decrypted fragmented MP4 for MSE, no ffmpeg needed.
import { createDecipheriv } from 'node:crypto';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'sinf', 'schi']);

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  for (let o = start; o + 8 <= end; ) {
    let size = buf.readUInt32BE(o);
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(o + 8));
      hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr) throw new Error('MP4 结构损坏');
    out.push({ type: buf.toString('latin1', o + 4, o + 8), start: o, body: o + hdr, end: o + size });
    o += size;
  }
  return out;
}

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
const full = (type, version, flags, ...parts) => box(type, u32((version << 24) | flags), ...parts);

function parseTrack(moov, trak, key) {
  const kids = (b) => boxes(moov, b.body, b.end);
  const get = (b, ...path) => {
    for (const t of path) {
      b = kids(b).find((x) => x.type === t);
      if (!b) return null;
    }
    return b;
  };
  const tkhd = get(trak, 'tkhd');
  const mdia = get(trak, 'mdia');
  const minf = get(mdia, 'minf');
  const stbl = get(minf, 'stbl');
  const id = moov.readUInt32BE(tkhd.body + (moov[tkhd.body] === 1 ? 20 : 12));
  const mdhd = get(mdia, 'mdhd');
  const timescale = moov.readUInt32BE(mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12));
  const handler = moov.toString('latin1', get(mdia, 'hdlr').body + 8, get(mdia, 'hdlr').body + 12);

  const table = (type) => {
    const b = get(stbl, type);
    if (!b) return null;
    const n = moov.readUInt32BE(b.body + 4);
    return { b, n, at: (i, w) => b.body + 8 + i * w };
  };
  // per-sample arrays
  const stsz = get(stbl, 'stsz');
  const fixed = moov.readUInt32BE(stsz.body + 4);
  const count = moov.readUInt32BE(stsz.body + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || moov.readUInt32BE(stsz.body + 12 + i * 4);

  const durations = new Uint32Array(count);
  const stts = table('stts');
  for (let i = 0, s = 0; i < stts.n; i++) {
    const n = moov.readUInt32BE(stts.at(i, 8));
    const d = moov.readUInt32BE(stts.at(i, 8) + 4);
    for (let k = 0; k < n && s < count; k++) durations[s++] = d;
  }
  const ctts = table('ctts');
  const cto = ctts ? new Int32Array(count) : null;
  if (ctts)
    for (let i = 0, s = 0; i < ctts.n; i++) {
      const n = moov.readUInt32BE(ctts.at(i, 8));
      const d = moov.readInt32BE(ctts.at(i, 8) + 4);
      for (let k = 0; k < n && s < count; k++) cto[s++] = d;
    }
  const stss = table('stss');
  const sync = stss ? new Uint8Array(count) : null;
  if (stss) for (let i = 0; i < stss.n; i++) sync[moov.readUInt32BE(stss.at(i, 4)) - 1] = 1;

  const co = table('stco') ?? table('co64');
  const wide = co.b.type === 'co64';
  const chunk = (i) => (wide ? Number(moov.readBigUInt64BE(co.at(i, 8))) : moov.readUInt32BE(co.at(i, 4)));
  const stsc = table('stsc');
  const offsets = new Float64Array(count);
  for (let e = 0, s = 0; e < stsc.n; e++) {
    const first = moov.readUInt32BE(stsc.at(e, 12)) - 1;
    const per = moov.readUInt32BE(stsc.at(e, 12) + 4);
    const last = e + 1 < stsc.n ? moov.readUInt32BE(stsc.at(e + 1, 12)) - 1 : co.n;
    for (let c = first; c < last; c++) {
      let o = chunk(c);
      for (let k = 0; k < per && s < count; k++) {
        offsets[s] = o;
        o += sizes[s++];
      }
    }
  }

  // sample entry: strip encryption (encv/enca -> original format, drop sinf)
  const stsd = get(stbl, 'stsd');
  const entry = boxes(moov, stsd.body + 8, stsd.end)[0];
  if (handler !== 'vide' && handler !== 'soun') return null;
  const fixedLen = handler === 'vide' ? 78 : 28;
  const inner = boxes(moov, entry.body + fixedLen, entry.end);
  const sinf = inner.find((b) => b.type === 'sinf');
  let format = entry.type;
  let ivs = null;
  if (sinf) {
    const sk = boxes(moov, sinf.body, sinf.end);
    format = moov.toString('latin1', sk.find((b) => b.type === 'frma').body, sk.find((b) => b.type === 'frma').body + 4);
    const schm = sk.find((b) => b.type === 'schm');
    const scheme = moov.toString('latin1', schm.body + 4, schm.body + 8);
    if (scheme !== 'cenc') throw new Error(`不支持的加密方式 ${scheme}`);
    const schi = sk.find((b) => b.type === 'schi');
    const tenc = boxes(moov, schi.body, schi.end).find((b) => b.type === 'tenc');
    const ivSize = moov[tenc.body + 7];
    const senc = get(stbl, 'senc');
    if (!senc || !key) throw new Error('缺少加密信息或内容密钥');
    const subs = moov.readUInt32BE(senc.body) & 2;
    const n = moov.readUInt32BE(senc.body + 4);
    ivs = new Array(n);
    for (let i = 0, p = senc.body + 8; i < n; i++) {
      const iv = Buffer.alloc(16);
      moov.copy(iv, 0, p, p + ivSize);
      p += ivSize;
      let parts = null;
      if (subs) {
        const k = moov.readUInt16BE(p);
        p += 2;
        parts = [];
        for (let j = 0; j < k; j++, p += 6) parts.push([moov.readUInt16BE(p), moov.readUInt32BE(p + 2)]);
      }
      ivs[i] = { iv, parts };
    }
  }
  const sampleEntry = box(
    format,
    moov.subarray(entry.body, entry.body + fixedLen),
    ...inner.filter((b) => b.type !== 'sinf').map((b) => moov.subarray(b.start, b.end))
  );
  const stsdBox = full('stsd', 0, 0, u32(1), sampleEntry);
  const empty = [full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0))];
  const raw = (b) => moov.subarray(b.start, b.end);
  const trakBox = box(
    'trak',
    ...kids(trak)
      .filter((b) => b.type !== 'mdia')
      .map(raw),
    box(
      'mdia',
      ...kids(mdia).map((b) =>
        b.type !== 'minf'
          ? raw(b)
          : box('minf', ...kids(minf).map((m) => (m.type === 'stbl' ? box('stbl', stsdBox, ...empty) : raw(m))))
      )
    )
  );
  return { id, timescale, handler, format, count, sizes, durations, cto, sync, offsets, ivs, trakBox };
}

export class Remuxer {
  // head: bytes from file start containing ftyp + moov
  constructor(head, keyHex) {
    const top = boxes(head);
    const ftyp = top.find((b) => b.type === 'ftyp');
    const moovBox = top.find((b) => b.type === 'moov');
    if (!moovBox || moovBox.end > head.length) throw new Error('moov 不在文件开头');
    const moov = head.subarray(moovBox.start, moovBox.end);
    const key = keyHex ? Buffer.from(keyHex, 'hex') : null;
    const inner = boxes(moov, 8, moov.length);
    this.tracks = inner.filter((b) => b.type === 'trak').map((t) => parseTrack(moov, t, key)).filter(Boolean);
    this.video = this.tracks.find((t) => t.handler === 'vide');
    this.audio = this.tracks.find((t) => t.handler === 'soun');
    if (!this.video) throw new Error('没有视频轨');
    this.key = key;
    const mvhd = inner.find((b) => b.type === 'mvhd');
    const trex = this.tracks.map((t) => full('trex', 0, 0, u32(t.id), u32(1), u32(0), u32(0), u32(0)));
    this.init = Buffer.concat([
      ftyp ? head.subarray(ftyp.start, ftyp.end) : box('ftyp', Buffer.from('isom\0\0\x02\0isomiso6mp41', 'latin1')),
      box('moov', moov.subarray(mvhd.start, mvhd.end), ...this.tracks.map((t) => t.trakBox), box('mvex', ...trex)),
    ]);
    // fragments: one per video GOP, audio cut at the same presentation time
    const v = this.video;
    const starts = [];
    for (let i = 0; i < v.count; i++) if (!v.sync || v.sync[i]) starts.push(i);
    const vTime = new Float64Array(v.count + 1);
    for (let i = 0; i < v.count; i++) vTime[i + 1] = vTime[i] + v.durations[i];
    const a = this.audio;
    const aTime = a ? new Float64Array(a.count + 1) : null;
    if (a) for (let i = 0; i < a.count; i++) aTime[i + 1] = aTime[i] + a.durations[i];
    this.fragments = [];
    let ai = 0;
    starts.forEach((s, k) => {
      const e = k + 1 < starts.length ? starts[k + 1] : v.count;
      const parts = [{ t: v, from: s, to: e, base: vTime[s] }];
      if (a) {
        const until = k + 1 < starts.length ? (vTime[e] / v.timescale) * a.timescale : Infinity;
        const from = ai;
        while (ai < a.count && aTime[ai] < until) ai++;
        if (ai > from) parts.push({ t: a, from, to: ai, base: aTime[from] });
      }
      let need = 0;
      for (const p of parts) for (let i = p.from; i < p.to; i++) need = Math.max(need, p.t.offsets[i] + p.t.sizes[i]);
      this.fragments.push({ parts, need });
    });
    this.next = 0;
  }

  sample(file, t, i) {
    const data = Buffer.from(file.subarray(t.offsets[i], t.offsets[i] + t.sizes[i]));
    const enc = t.ivs?.[i];
    if (!enc) return data;
    const d = createDecipheriv('aes-128-ctr', this.key, enc.iv);
    if (!enc.parts) return d.update(data);
    for (let p = 0, j = 0; j < enc.parts.length; j++) {
      const [clear, prot] = enc.parts[j];
      p += clear;
      d.update(data.subarray(p, p + prot)).copy(data, p);
      p += prot;
    }
    return data;
  }

  // returns fMP4 segments whose sample bytes are all within file[0, have)
  drain(file, have) {
    const out = [];
    while (this.next < this.fragments.length && this.fragments[this.next].need <= have) {
      const { parts } = this.fragments[this.next++];
      const payloads = parts.map((p) => {
        const list = [];
        for (let i = p.from; i < p.to; i++) list.push(this.sample(file, p.t, i));
        return list;
      });
      const traf = (p, dataOffset) => {
        const { t } = p;
        const n = p.to - p.from;
        const flags = 0x001 | 0x100 | 0x200 | 0x400 | (t.cto ? 0x800 : 0);
        const rows = [];
        for (let i = p.from; i < p.to; i++) {
          const key = !t.sync || t.sync[i];
          rows.push(u32(t.durations[i]), u32(t.sizes[i]), u32(key ? 0x02000000 : 0x01010000));
          if (t.cto) rows.push(u32(t.cto[i]));
        }
        const base = Buffer.alloc(8);
        base.writeBigUInt64BE(BigInt(p.base));
        return box(
          'traf',
          full('tfhd', 0, 0x020000, u32(t.id)),
          full('tfdt', 1, 0, base),
          full('trun', t.cto ? 1 : 0, flags, u32(n), u32(dataOffset), ...rows)
        );
      };
      const mfhd = full('mfhd', 0, 0, u32(this.next));
      const build = (offsets) => box('moof', mfhd, ...parts.map((p, k) => traf(p, offsets[k])));
      const lens = payloads.map((l) => l.reduce((s, b) => s + b.length, 0));
      const moofLen = build(parts.map(() => 0)).length;
      const offsets = [];
      for (let k = 0, o = moofLen + 8; k < parts.length; o += lens[k++]) offsets.push(o);
      const mdat = Buffer.concat(payloads.flat());
      out.push(build(offsets), Buffer.concat([u32(mdat.length + 8), Buffer.from('mdat'), mdat]));
    }
    return out;
  }

  get done() {
    return this.next >= this.fragments.length;
  }
}
