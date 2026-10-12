// 2D input: WASD/arrows (the last pressed axis wins, GBA style), Shift to run, E/Enter to interact,
// O for the overview, Esc, the wheel to zoom, click and hover on the canvas. M and J belong to the
// HUD (DOM). Keys are ignored while suspended (a dialog or panel is open) or typing in a field.
import type { Dir4 } from '../../app/pixel/types.ts'

const MOVE: Record<string, Dir4> = {
  KeyW: 'n',
  ArrowUp: 'n',
  KeyS: 's',
  ArrowDown: 's',
  KeyA: 'w',
  ArrowLeft: 'w',
  KeyD: 'e',
  ArrowRight: 'e',
}

export interface InputHandlers {
  interact(): void
  overview(): void
  escape(): void
  zoom(delta: 1 | -1): void
  click(clientX: number, clientY: number): void
  hover(clientX: number, clientY: number): void
  leave(): void
  /** Any movement key pressed (stops following / camera pans). */
  moved(): void
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLInputElement ||
  t instanceof HTMLTextAreaElement ||
  t instanceof HTMLSelectElement ||
  (t instanceof HTMLElement && t.isContentEditable)

export class PixelInput {
  /** Pressed movement keys, oldest first. */
  private held: string[] = []
  run = false
  suspended = false
  lastInputAt = -Infinity
  private off: (() => void)[] = []

  constructor(
    canvas: HTMLCanvasElement,
    private h: InputHandlers,
  ) {
    const on = <E extends Event>(
      t: EventTarget,
      type: string,
      fn: (e: E) => void,
      opts?: AddEventListenerOptions,
    ) => {
      const l = fn as EventListener
      t.addEventListener(type, l, opts)
      this.off.push(() => t.removeEventListener(type, l, opts))
    }
    on<KeyboardEvent>(window, 'keydown', (e) => this.keydown(e))
    on<KeyboardEvent>(window, 'keyup', (e) => {
      this.held = this.held.filter((k) => k !== e.code)
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.run = false
    })
    on(window, 'blur', () => this.release())
    on<WheelEvent>(
      canvas,
      'wheel',
      (e) => {
        e.preventDefault()
        this.mark()
        this.h.zoom(e.deltaY < 0 ? 1 : -1)
      },
      { passive: false },
    )
    let down: [number, number] | null = null
    on<PointerEvent>(canvas, 'pointerdown', (e) => (down = [e.clientX, e.clientY]))
    on<PointerEvent>(canvas, 'pointerup', (e) => {
      if (!down) return
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1])
      down = null
      if (moved > 5 || this.suspended) return
      this.mark()
      this.h.click(e.clientX, e.clientY)
    })
    on<PointerEvent>(canvas, 'pointermove', (e) => {
      if (e.buttons === 0) this.h.hover(e.clientX, e.clientY)
    })
    on(canvas, 'pointerleave', () => this.h.leave())
  }

  private mark(): void {
    this.lastInputAt = performance.now()
  }

  private keydown(e: KeyboardEvent): void {
    if (typing(e.target)) return
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.run = true
    if (this.suspended) return
    const dir = MOVE[e.code]
    if (dir) {
      e.preventDefault()
      if (!this.held.includes(e.code)) this.held.push(e.code)
      this.mark()
      this.h.moved()
      return
    }
    if (e.repeat) return
    if (e.code === 'KeyE' || e.code === 'Enter') {
      this.mark()
      this.h.interact()
    } else if (e.code === 'KeyO') {
      this.mark()
      this.h.overview()
    } else if (e.code === 'Escape') this.h.escape()
  }

  /** The direction to walk now (null: standing still). */
  direction(): Dir4 | null {
    if (this.suspended) return null
    const k = this.held[this.held.length - 1]
    return k ? MOVE[k]! : null
  }

  setSuspended(on: boolean): void {
    this.suspended = on
    if (on) this.release()
  }

  release(): void {
    this.held = []
    this.run = false
  }

  dispose(): void {
    for (const off of this.off.splice(0)) off()
    this.release()
  }
}
