/** DOM text only via textContent / createElement (PRIVACY_SECURITY rule). Never innerHTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (text !== undefined) e.textContent = text
  if (className) e.className = className
  return e
}

export const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
