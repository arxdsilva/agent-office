import { describe, expect, it } from 'vitest'
import { DETAIL_DISTANCE, moduleCulling } from './culling.ts'

describe('moduleCulling', () => {
  it('shows every module in the view frustum, however far (the overview sees the whole HQ)', () => {
    expect(moduleCulling(true, 160)).toEqual({ visible: true, detail: false })
    expect(moduleCulling(true, 400)).toEqual({ visible: true, detail: false })
  })

  it('hides modules outside the frustum', () => {
    expect(moduleCulling(false, 5).visible).toBe(false)
  })

  it('shows small detail (spines, boards, kiosk screens) only up close', () => {
    expect(moduleCulling(true, DETAIL_DISTANCE - 1).detail).toBe(true)
    expect(moduleCulling(true, DETAIL_DISTANCE + 1).detail).toBe(false)
  })

  it('CU-1: the detail distance comes from the graphics settings (detailCullM)', () => {
    expect(moduleCulling(true, 20, 16).detail).toBe(false)
    expect(moduleCulling(true, 15, 16).detail).toBe(true)
    expect(moduleCulling(true, 40, 48).detail).toBe(true)
    expect(moduleCulling(false, 1, 48).detail).toBe(false)
  })
})
