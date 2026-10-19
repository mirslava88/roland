interface SlideReply {
  success: boolean
  output?: string
}

// Keynote acknowledges Next before long transitions update CurrentSlide.
// Poll only the latest navigation session; a build on the same slide is valid.
export function reconcileMacSlide(
  initialSlide: number,
  isCurrent: () => boolean,
  read: () => Promise<SlideReply>,
  apply: (slide: number) => void
): void {
  const delays = [500, 750, 1000, 1500]
  let attempt = 0
  const check = async (): Promise<void> => {
    if (!isCurrent()) return
    try {
      const result = await read()
      if (!isCurrent()) return
      const slide = result.success && result.output ? JSON.parse(result.output).CurrentSlide : null
      if (Number.isInteger(slide) && slide > 0 && slide !== initialSlide) {
        apply(slide)
        return
      }
    } catch { /* the next bounded check can recover a transient Office error */ }
    if (isCurrent() && attempt < delays.length) setTimeout(() => { void check() }, delays[attempt++])
  }
  setTimeout(() => { void check() }, delays[attempt++])
}
