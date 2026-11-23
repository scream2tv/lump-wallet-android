import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

type Detector = { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> }
declare global { interface Window { BarcodeDetector?: new (opts: { formats: string[] }) => Detector } }

/**
 * Full-screen QR scanner for addresses. Uses the platform BarcodeDetector when it exists, otherwise decodes
 * frames with jsQR. `accept` validates a decoded string; a rejected code shows `reason` and scanning continues.
 */
export function Scan({ accept, onResult, onCancel }: { accept: (text: string) => string | null; onResult: (text: string) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState('')
  const [hint, setHint] = useState('')
  // the parent re-renders every second with fresh callbacks; keep the camera session independent of that
  const acceptRef = useRef(accept); acceptRef.current = accept
  const onResultRef = useRef(onResult); onResultRef.current = onResult

  useEffect(() => {
    const accept = (t: string) => acceptRef.current(t)
    const onResult = (t: string) => onResultRef.current(t)
    let stream: MediaStream | null = null
    let stop = false
    let raf = 0
    const video = videoRef.current!
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const detector = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null
    let lastHint = 0

    const handle = (text: string) => {
      const why = accept(text)
      if (why == null) { stop = true; onResult(text); return }
      if (Date.now() - lastHint > 1500) { lastHint = Date.now(); setHint(why) }
    }

    const tick = async () => {
      if (stop) return
      if (video.readyState >= 2) {
        try {
          if (detector) {
            const codes = await detector.detect(video)
            if (codes[0]?.rawValue) handle(codes[0].rawValue)
          } else if (ctx) {
            const w = video.videoWidth, h = video.videoHeight
            if (w && h) {
              const scale = Math.min(1, 640 / w)
              canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale)
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
              const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
              if (code?.data) handle(code.data)
            }
          }
        } catch {}
      }
      if (!stop) raf = window.setTimeout(tick, detector ? 150 : 120) as unknown as number
    }

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => { if (stop) { s.getTracks().forEach((t) => t.stop()); return } stream = s; video.srcObject = s; return video.play().then(tick) })
      .catch((e) => setErr(/NotAllowed|Permission/i.test(String(e?.name ?? e)) ? 'Camera access was denied. Allow it in your browser settings and try again.' : 'No camera available on this device.'))

    return () => { stop = true; clearTimeout(raf); stream?.getTracks().forEach((t) => t.stop()) }
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', display: 'grid', gridTemplateRows: 'auto 1fr auto' }}>
      <div className="row spread" style={{ padding: 'calc(var(--sat) + 17px) var(--gutter) 13px', color: '#fff' }}>
        <button data-back onClick={onCancel}>Cancel</button>
        <span style={{ fontWeight: 600 }}>Scan address</span>
        <span style={{ width: 47 }} />
      </div>
      <div style={{ position: 'relative', overflow: 'hidden' }}>
        <video ref={videoRef} playsInline muted autoPlay style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <div style={{ width: 'min(71vw, 283px)', aspectRatio: '1', border: '3px solid rgba(255,255,255,.85)', borderRadius: 19, boxShadow: '0 0 0 9999px rgba(0,0,0,.45)' }} />
        </div>
        {err && <div className="card" style={{ position: 'absolute', left: 17, right: 17, bottom: 17 }}><div className="err">{err}</div></div>}
      </div>
      <div className="tiny" style={{ textAlign: 'center', padding: '13px var(--gutter) calc(var(--sab) + 23px)', color: hint ? 'var(--warn)' : 'var(--fg-2)', minHeight: 47 }}>
        {hint || 'Point the camera at a Midnight address QR code'}
      </div>
    </div>
  )
}
