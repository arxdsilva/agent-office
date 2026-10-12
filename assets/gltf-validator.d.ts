// Minimal types for the Khronos glTF validator (the npm package ships none).
declare module 'gltf-validator' {
  export interface ValidationMessage {
    code: string
    message: string
    /** 0 error, 1 warning, 2 info, 3 hint. */
    severity: number
    pointer?: string
  }
  export interface ValidationReport {
    issues: {
      numErrors: number
      numWarnings: number
      numInfos: number
      numHints: number
      messages: ValidationMessage[]
      truncated: boolean
    }
  }
  export interface ValidationOptions {
    uri?: string
    format?: 'glb' | 'gltf'
    maxIssues?: number
    ignoredIssues?: string[]
    externalResourceFunction?: (uri: string) => Promise<Uint8Array>
  }
  const validator: {
    version(): string
    validateBytes(data: Uint8Array, options?: ValidationOptions): Promise<ValidationReport>
  }
  export default validator
}
