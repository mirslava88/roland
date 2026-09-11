let qrEditorOwnsOutput = false

export function isQrEditorOutputOwned(): boolean {
  return qrEditorOwnsOutput
}

export function setQrEditorOutputOwned(owned: boolean): void {
  qrEditorOwnsOutput = owned
}
