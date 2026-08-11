import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { BroadcastTitleEffect, BroadcastTitlesOutput } from '../../stores/useAppStore'

interface BroadcastTitlesOverlayProps {
  titles: BroadcastTitlesOutput
  className?: string
}

type MotionPhase = 'enter' | 'steady' | 'exit' | 'hidden'

interface AnimatedValue<T> {
  content: T | null
  phase: MotionPhase
  revision: number
}

function useAnimatedValue<T>(visible: boolean, content: T, identity: string): AnimatedValue<T> {
  const [value, setValue] = useState<AnimatedValue<T>>({ content: null, phase: 'hidden', revision: 0 })
  const lastIdentity = useRef('')

  useEffect(() => {
    let finishTimer: ReturnType<typeof setTimeout> | undefined

    if (visible) {
      const shouldEnter = identity !== lastIdentity.current || value.phase === 'hidden' || value.phase === 'exit'
      lastIdentity.current = identity
      setValue((current) => ({
        content,
        phase: shouldEnter ? 'enter' : 'steady',
        revision: shouldEnter ? current.revision + 1 : current.revision
      }))
      if (shouldEnter) {
        finishTimer = setTimeout(() => {
          setValue((current) => current.phase === 'enter' ? { ...current, phase: 'steady' } : current)
        }, 520)
      }
    } else if (value.content && value.phase !== 'exit' && value.phase !== 'hidden') {
      setValue((current) => ({ ...current, phase: 'exit' }))
      finishTimer = setTimeout(() => {
        setValue((current) => current.phase === 'exit'
          ? { content: null, phase: 'hidden', revision: current.revision }
          : current)
      }, 520)
    }

    return () => {
      if (finishTimer) clearTimeout(finishTimer)
    }
  }, [visible, identity])

  return value
}

function motionClass(phase: MotionPhase, effect: BroadcastTitleEffect): string {
  return `broadcast-title-motion broadcast-title-motion--${phase} broadcast-title-effect--${effect}`
}

export function BroadcastTitlesOverlay({
  titles,
  className = ''
}: BroadcastTitlesOverlayProps): JSX.Element | null {
  const speakerName = titles.speakerName.trim()
  const speakerRole = titles.speakerRole.trim()
  const eventLabel = titles.eventLabel.trim()
  const eventInfo = titles.eventInfo.trim()
  const speakerVisible = titles.speakerVisible && speakerName.length > 0
  const eventVisible = titles.eventVisible && eventInfo.length > 0

  const speaker = useAnimatedValue(
    speakerVisible,
    {
      name: speakerName,
      role: speakerRole,
      enterEffect: titles.speakerEnterEffect,
      exitEffect: titles.speakerExitEffect,
      style: titles.speakerStyle,
      textColor: titles.speakerTextColor,
      backgroundStart: titles.speakerBackgroundStart,
      backgroundEnd: titles.speakerBackgroundEnd,
      accentStart: titles.speakerAccentStart,
      accentEnd: titles.speakerAccentEnd
    },
    `${titles.speakerId || ''}\u0000${speakerName}\u0000${speakerRole}\u0000${titles.speakerEnterEffect}\u0000${titles.speakerExitEffect}\u0000${titles.speakerStyle}\u0000${titles.speakerTextColor}\u0000${titles.speakerBackgroundStart}\u0000${titles.speakerBackgroundEnd}\u0000${titles.speakerAccentStart}\u0000${titles.speakerAccentEnd}`
  )
  const event = useAnimatedValue(
    eventVisible,
    {
      label: eventLabel,
      info: eventInfo,
      position: titles.eventPosition,
      enterEffect: titles.eventEnterEffect,
      exitEffect: titles.eventExitEffect,
      style: titles.eventStyle,
      textColor: titles.eventTextColor,
      backgroundStart: titles.eventBackgroundStart,
      backgroundEnd: titles.eventBackgroundEnd,
      accentStart: titles.eventAccentStart,
      accentEnd: titles.eventAccentEnd
    },
    `${eventLabel}\u0000${eventInfo}\u0000${titles.eventPosition}\u0000${titles.eventEnterEffect}\u0000${titles.eventExitEffect}\u0000${titles.eventStyle}\u0000${titles.eventTextColor}\u0000${titles.eventBackgroundStart}\u0000${titles.eventBackgroundEnd}\u0000${titles.eventAccentStart}\u0000${titles.eventAccentEnd}`
  )

  if (!speaker.content && !event.content) return null

  return (
    <div className={`broadcast-titles-layer ${className}`} aria-hidden="true">
      {event.content && (
        <div
          key={`event-${event.revision}`}
          className={`broadcast-event-title broadcast-title-style--${event.content.style} broadcast-event-position--${event.content.position} ${motionClass(
            event.phase,
            event.phase === 'exit' ? event.content.exitEffect : event.content.enterEffect
          )}`}
          style={{
            '--broadcast-title-text': event.content.textColor,
            '--broadcast-title-bg-start': event.content.backgroundStart,
            '--broadcast-title-bg-end': event.content.backgroundEnd,
            '--broadcast-title-accent-start': event.content.accentStart,
            '--broadcast-title-accent-end': event.content.accentEnd
          } as CSSProperties}
        >
          {event.content.label && <div className="broadcast-event-title-label">{event.content.label}</div>}
          <div className="broadcast-event-title-text">{event.content.info}</div>
        </div>
      )}

      {speaker.content && (
        <div
          key={`speaker-${speaker.revision}`}
          className={`broadcast-speaker-title broadcast-title-style--${speaker.content.style} ${motionClass(
            speaker.phase,
            speaker.phase === 'exit' ? speaker.content.exitEffect : speaker.content.enterEffect
          )}`}
          style={{
            '--broadcast-title-text': speaker.content.textColor,
            '--broadcast-title-bg-start': speaker.content.backgroundStart,
            '--broadcast-title-bg-end': speaker.content.backgroundEnd,
            '--broadcast-title-accent-start': speaker.content.accentStart,
            '--broadcast-title-accent-end': speaker.content.accentEnd
          } as CSSProperties}
        >
          <div className="broadcast-speaker-accent" />
          <div className="broadcast-speaker-copy">
            <div className="broadcast-speaker-name">{speaker.content.name}</div>
            {speaker.content.role && <div className="broadcast-speaker-role">{speaker.content.role}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
