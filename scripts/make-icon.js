'use strict'
// Generates build/icon.png (256x256) and build/icon.ico with no external deps.
// Draws a rounded blue app tile with two toggle "switches" (account-switch
// motif). Rendered 4x supersampled, then box-downscaled for clean anti-aliasing.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const OUT = 256
const SS = 4 // supersample factor
const S = OUT * SS // hi-res canvas size

// ---- hi-res RGBA canvas ----
const buf = new Float64Array(S * S * 4) // r,g,b,a in 0..255

function blend (x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return
  const i = (y * S + x) * 4
  const sa = a / 255
  const da = buf[i + 3] / 255
  const oa = sa + da * (1 - sa)
  if (oa <= 0) return
  buf[i] = (r * sa + buf[i] * da * (1 - sa)) / oa
  buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / oa
  buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / oa
  buf[i + 3] = oa * 255
}

// Filled rounded rectangle (hard edges; AA comes from downscaling).
function roundRect (x0, y0, w, h, rad, colorAt) {
  const x1 = x0 + w
  const y1 = y0 + h
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      let inside = true
      // corner clipping
      const cx = x < x0 + rad ? x0 + rad : (x > x1 - rad ? x1 - rad : x)
      const cy = y < y0 + rad ? y0 + rad : (y > y1 - rad ? y1 - rad : y)
      if (cx !== x && cy !== y) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy > rad * rad) inside = false
      }
      if (inside) {
        const c = colorAt(x, y)
        blend(x, y, c[0], c[1], c[2], c[3])
      }
    }
  }
}

function circle (cx, cy, rad, color) {
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= rad * rad) blend(x, y, color[0], color[1], color[2], color[3])
    }
  }
}

// scale helper: design in 256-space, multiply by SS
const u = (n) => n * SS

// --- tile with vertical blue gradient (#4f8cff -> #6ea8fe) ---
const top = [79, 140, 255]
const bot = [110, 168, 254]
roundRect(u(10), u(10), u(236), u(236), u(54), (x, y) => {
  const t = (y / S)
  return [
    top[0] + (bot[0] - top[0]) * t,
    top[1] + (bot[1] - top[1]) * t,
    top[2] + (bot[2] - top[2]) * t,
    255
  ]
})

// --- two toggle switches ---
// track: translucent white pill; knob: solid white circle
const trackCol = [255, 255, 255, 70]
const knobCol = [255, 255, 255, 255]
const trackW = 150
const trackH = 56
const trackX = (256 - trackW) / 2
const rTrack = trackH / 2
const knobR = (trackH - 16) / 2

// top switch: knob to the right (ON)
roundRect(u(trackX), u(80), u(trackW), u(trackH), u(rTrack), () => trackCol)
circle(u(trackX + trackW - rTrack), u(80 + rTrack), u(knobR), knobCol)

// bottom switch: knob to the left (OFF)
roundRect(u(trackX), u(120), u(trackW), u(trackH), u(rTrack), () => trackCol)
circle(u(trackX + rTrack), u(120 + rTrack), u(knobR), knobCol)

// ---- downscale (box filter) to OUT x OUT RGBA8 ----
const out = Buffer.alloc(OUT * OUT * 4)
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * S + (x * SS + sx)) * 4
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]
      }
    }
    const n = SS * SS
    const o = (y * OUT + x) * 4
    out[o] = Math.round(r / n)
    out[o + 1] = Math.round(g / n)
    out[o + 2] = Math.round(b / n)
    out[o + 3] = Math.round(a / n)
  }
}

// ---- PNG encode ----
function crc32 (buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function encodePng (rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const png = encodePng(out, OUT, OUT)

// ---- ICO wrapper (PNG-in-ICO, supported Vista+) ----
function encodeIco (png) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = 0; entry[1] = 0 // 256x256 encoded as 0
  entry[2] = 0; entry[3] = 0
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(6 + 16, 12)
  return Buffer.concat([dir, entry, png])
}

const buildDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(buildDir, { recursive: true })
fs.writeFileSync(path.join(buildDir, 'icon.png'), png)
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(png))
console.log('wrote build/icon.png (' + png.length + 'b) and build/icon.ico')
