import { useEffect, useState } from 'react'
import type { BroadcastTitlesOutput } from '../../stores/useAppStore'
import { BroadcastTitlesOverlay } from '../BroadcastTitles/BroadcastTitlesOverlay'

interface InformationTitlesUpdate {
  titleSourceIdentity: string | null
  titles: BroadcastTitlesOutput | null
}

const EMPTY_INFORMATION_TITLES: InformationTitlesUpdate = {
  titleSourceIdentity: null,
  titles: null
}

export function InformationTitlesLayer(): JSX.Element | null {
  const [state, setState] = useState<InformationTitlesUpdate>(EMPTY_INFORMATION_TITLES)

  useEffect(() => window.api.on('information-titles-update', (...args: unknown[]) => {
    const update = args[0] as Partial<InformationTitlesUpdate> | undefined
    const titles = update?.titles || null
    const titleSourceIdentity = typeof update?.titleSourceIdentity === 'string'
      ? update.titleSourceIdentity
      : null
    setState({ titleSourceIdentity, titles })
    window.api.dbgLog(
      `information titles received source=${titleSourceIdentity ? 'set' : 'none'} ` +
      `speaker=${titles?.speakerVisible === true} event=${titles?.eventVisible === true}`
    )
  }), [])

  if (!state.titles) return null
  return (
    <div data-information-titles-layer className="absolute inset-0 z-50 pointer-events-none">
      <BroadcastTitlesOverlay
        key={state.titleSourceIdentity || 'no-information-title-source'}
        titles={state.titles}
      />
    </div>
  )
}
