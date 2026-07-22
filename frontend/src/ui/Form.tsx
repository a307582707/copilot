import type { HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

export function FormField(
  props: HTMLAttributes<HTMLDivElement> & {
    label?: ReactNode
    required?: boolean
    error?: string
    help?: string
  },
) {
  const { className, label, required, error, help, children, ...rest } = props
  return (
    <div {...rest} className={cn('ui-field', error && 'ui-field--error', className)}>
      {label ? (
        <label className="ui-label">
          {label}
          {required ? <span className="ui-labelRequired">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? <div className="ui-fieldError">{error}</div> : null}
      {help && !error ? <div className="ui-fieldHelp">{help}</div> : null}
    </div>
  )
}

export function FormInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props
  return <input {...rest} className={cn('ui-input', className)} />
}

export function FormTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props
  return <textarea {...rest} className={cn('ui-textarea', className)} />
}

export function FormSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props
  return <select {...rest} className={cn('ui-select', className)} />
}

export function FormSwitch(
  props: InputHTMLAttributes<HTMLInputElement> & {
    label?: ReactNode
  },
) {
  const { className, label, ...rest } = props
  return (
    <label className={cn('ui-switch', className)}>
      <input {...rest} type="checkbox" className="ui-switchInput" />
      <span className="ui-switchTrack">
        <span className="ui-switchThumb" />
      </span>
      {label ? <span className="ui-switchLabel">{label}</span> : null}
    </label>
  )
}
