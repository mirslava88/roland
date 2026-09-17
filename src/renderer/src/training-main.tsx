import { installTrainingRuntime, TRAINING_FILE, TRAINING_FILE_SECOND, trainingFrames, trainingFramesSecond, trainingCalls, emitTraining } from './components/Onboarding/training-runtime'
import './assets/index.css'
import './components/Onboarding/introduction.css'

try {
  installTrainingRuntime()
  // Dynamic imports ensure the real store hydrates only from in-memory storage.
  void Promise.all([import('react'), import('react-dom/client'), import('./App'), import('./stores/useAppStore'), import('./components/Onboarding/InterfaceTour')]).then(([React, ReactDOM, { default: App }, { useAppStore }, { InterfaceTour }]) => {
    const query = new URLSearchParams(location.search)
    const step = Math.max(0, Math.min(30, Number(query.get('step')) || 0))
    const theme = query.get('theme') === 'classic' ? 'classic' : 'broadcast-pro'
    const state = useAppStore.getState()
    const channelId = state.channelIds[0]
    const secondChannelId = state.channelIds[1]
    useAppStore.setState({ folderPath: 'Учебные материалы', files: [TRAINING_FILE, TRAINING_FILE_SECOND], filteredFiles: [TRAINING_FILE, TRAINING_FILE_SECOND], subfolders: [], appTheme: theme,
      pptxSlidesMap: { [TRAINING_FILE.path]: trainingFrames, [TRAINING_FILE_SECOND.path]: trainingFramesSecond },
      pptxThumbnailsMap: { [TRAINING_FILE.path]: trainingFrames, [TRAINING_FILE_SECOND.path]: trainingFramesSecond },
      pptxCacheStatuses: { [TRAINING_FILE.path]: 'ready', [TRAINING_FILE_SECOND.path]: 'ready' },
      pptxAspectRatios: { [TRAINING_FILE.path]: 16 / 9, [TRAINING_FILE_SECOND.path]: 16 / 9 },
      displayAssignments: { 2: 'program' }, selectedDisplayId: 2 })
    state.setBroadcastTitles({
      speakers: [{ id: 'training-speaker', name: step >= 25 ? 'Анна Петрова' : '', role: 'Спикер' }],
      selectedSpeakerId: 'training-speaker',
      eventInfo: step >= 25 ? 'Учебная конференция 2026' : ''
    })
    if (step >= 1) { state.setChannelFile(channelId, TRAINING_FILE); state.setChannelTotalSlides(channelId, 3) }
    if (step >= 2) { state.setChannelFile(secondChannelId, TRAINING_FILE_SECOND); state.setChannelTotalSlides(secondChannelId, 3) }
    if (step >= 3) state.setSelectedChannel(channelId)
    const take = (requestedId?: string): void => {
      const s = useAppStore.getState(), id = requestedId || s.selectedChannel || channelId
      if (!s.channels[id]?.file) return
      s.setSelectedChannel(id); s.setLiveChannel(id); s.setActiveFile(s.channels[id].file); s.setTotalSlides(3); s.setPresentationWindowOpen(true)
      window.dispatchEvent(new CustomEvent('take-channel-completed', { detail: { channelId: id } }))
    }
    if (step >= 4) take(channelId)
    if (step >= 5) state.setSelectedChannel(secondChannelId)
    if (step >= 6) take(secondChannelId)
    if (step >= 7) state.setCurrentSlide(2)
    if (step >= 18) state.setProgramScene({ textOverlays: [{ id: 'training-text', text: 'Мой первый показ', visible: true, xPercent: 10, yPercent: 10, widthPercent: 34, fontFamily: 'arial', fontSizePercent: 4, color: '#ffffff' }] })
    if (step >= 19) { state.setProgramScene({ enabled: true }); state.publishProgramSnapshot(secondChannelId); emitTraining('program-scene-applied', { revision: useAppStore.getState().programSnapshot?.revision }) }
    if (step >= 22) {
      state.addCaptureSource({
        id: 'training-capture', name: 'Учебная камера с зелёным фоном', path: 'capture://training-capture', type: 'capture', extension: 'LIVE', size: 0, sceneOnly: true,
        capture: { sourceId: 'training-capture', captureKind: 'device', videoDeviceId: 'training-camera', videoLabel: 'Учебная камера с зелёным фоном', videoGroupId: 'training-camera-group', audioEnabled: false }
      })
      state.setProgramScene({ captureSourceId: 'training-capture' })
    }
    if (step >= 23) state.setProgramScene({ chromaKey: { ...useAppStore.getState().programScene.chromaKey, enabled: true } })
    if (step >= 24) state.setQrOverlay({ contentType: 'url', url: 'https://pdm.example', sceneVisible: true })
    const stop = (): void => {
      const s = useAppStore.getState(); s.setProgramScene({ enabled: false }); s.clearProgramSnapshot()
      useAppStore.setState({ activeFile: null, liveChannel: null, isPresentationWindowOpen: false })
    }
    // The real operator buttons remain in their real places. Only physical TAKE
    // is simulated; scene drafting, text editing and publication use real code.
    window.addEventListener('click', event => {
      if ((event.target as Element).closest('[data-toolbar-item="output"] button')) {
        event.preventDefault(); event.stopImmediatePropagation()
        const selected = useAppStore.getState().selectedChannel
        if (selected && useAppStore.getState().liveChannel === selected) stop(); else take()
      }
    }, true)
    window.addEventListener('take-channel', event => { event.stopImmediatePropagation(); take() }, true)
    window.addEventListener('close-program-output', event => { event.stopImmediatePropagation(); stop() }, true)
    ReactDOM.createRoot(document.getElementById('root')!).render(React.createElement(React.Fragment, null,
      React.createElement(App, { training: true }), React.createElement(InterfaceTour, { initialStep: step })))
    if (step >= 15 && step <= 26) {
      setTimeout(() => {
        window.dispatchEvent(new Event('open-program-scene'))
        if (step === 24 || step === 25) setTimeout(() => (document.querySelector('[data-scene-panel="titles"]') as HTMLButtonElement | null)?.click(), 450)
      }, 350)
    }
    // Inspection is local to the sandbox, never exposed by the main preload.
    Object.assign(window, { trainingStore: useAppStore, trainingCalls })
  }).catch(showFailure)
} catch (error) { showFailure(error) }

function showFailure(error: unknown): void {
  const root = document.getElementById('root')!
  root.textContent = `Не удалось открыть безопасное обучение: ${String(error)}. Закройте его и попробуйте снова.`
  root.style.cssText = 'padding:32px;color:white;background:#10171d;height:100vh'
}
