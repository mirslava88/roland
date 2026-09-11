import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface SceneLayerControlBarProps {
  active: boolean
  status: string
  detail: string
  children: ReactNode
}

export function SceneLayerControlBar({
  active,
  status,
  detail,
  children
}: SceneLayerControlBarProps): JSX.Element {
  return (
    <div
      data-scene-air-bar
      className="mb-2 flex min-h-11 shrink-0 items-center justify-between gap-4 rounded-lg border border-gray-700 bg-surface-200 px-3 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${active
            ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.5)]'
            : 'bg-gray-600'}`}
        />
        <div className="min-w-0 leading-tight">
          <div data-scene-air-status className={`truncate text-xs font-semibold ${active ? 'text-emerald-300' : 'text-gray-300'}`}>
            {status}
          </div>
          <div className="truncate text-[10px] text-gray-500">{detail}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

interface SceneLayerCheckboxProps {
  children: ReactNode
  checked: boolean
  disabled?: boolean
  title?: string
  inputProps?: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'disabled' | 'onChange'>
  onChange: (checked: boolean) => void
}

export function SceneLayerCheckbox({
  children,
  checked,
  disabled = false,
  title,
  inputProps,
  onChange
}: SceneLayerCheckboxProps): JSX.Element {
  return (
    <label
      title={title}
      className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10px] font-medium transition-colors ${
        disabled
          ? 'cursor-not-allowed border-gray-800 bg-surface-100 text-gray-600'
          : checked
            ? 'cursor-pointer border-emerald-700/80 bg-emerald-950/45 text-emerald-300'
            : 'cursor-pointer border-gray-700 bg-surface-100 text-gray-400 hover:border-gray-600 hover:text-gray-200'
      }`}
    >
      <input
        {...inputProps}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-emerald-500"
      />
      {children}
    </label>
  )
}

interface SceneLayerToggleButtonProps {
  children: ReactNode
  pressed: boolean
  disabled?: boolean
  tone?: 'default' | 'air'
  title?: string
  buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'disabled' | 'aria-pressed' | 'onClick' | 'className'>
  onPressedChange: (pressed: boolean) => void
}

export function SceneLayerToggleButton({
  children,
  pressed,
  disabled = false,
  tone = 'default',
  title,
  buttonProps,
  onPressedChange
}: SceneLayerToggleButtonProps): JSX.Element {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={() => onPressedChange(!pressed)}
      className={`h-7 rounded-md border px-3 text-[10px] font-semibold transition-colors ${
        disabled
          ? 'cursor-not-allowed border-gray-800 bg-surface-100 text-gray-600'
          : tone === 'air'
            ? pressed
              ? 'border-red-400 bg-red-600 text-white shadow-[0_0_10px_rgba(220,38,38,.35)] hover:bg-red-500'
              : 'border-red-700 bg-red-950/65 text-red-200 hover:border-red-500 hover:bg-red-800 hover:text-white'
            : pressed
              ? 'border-emerald-600 bg-emerald-700 text-white hover:bg-emerald-600'
              : 'border-gray-700 bg-surface-100 text-gray-300 hover:border-gray-600 hover:bg-gray-700 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}
