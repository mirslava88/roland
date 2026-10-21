/** Office lock files (for example ~$Presentation.pptx) are not usable media. */
export function visibleLibraryFiles<T extends { name: string }>(files: T[]): T[] {
  return files.filter((file) => !file.name.startsWith('~'))
}
