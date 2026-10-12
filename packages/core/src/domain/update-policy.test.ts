import { describe, expect, it } from 'vitest'
import { updatePolicy } from './update-policy.ts'

const base = {
  packaged: true,
  platform: 'win32',
  signed: false,
  enabled: true,
  linuxAppImage: false,
}

describe('updatePolicy', () => {
  it('is off in development or when disabled', () => {
    expect(updatePolicy({ ...base, packaged: false })).toBe('off')
    expect(updatePolicy({ ...base, enabled: false })).toBe('off')
  })
  it('auto-updates on Windows and Linux AppImage', () => {
    expect(updatePolicy(base)).toBe('auto')
    expect(updatePolicy({ ...base, platform: 'linux', linuxAppImage: true })).toBe('auto')
  })
  it('only notifies for unsigned macOS and non-AppImage Linux', () => {
    expect(updatePolicy({ ...base, platform: 'darwin' })).toBe('notify-only')
    expect(updatePolicy({ ...base, platform: 'darwin', signed: true })).toBe('auto')
    expect(updatePolicy({ ...base, platform: 'linux' })).toBe('notify-only')
  })
})
