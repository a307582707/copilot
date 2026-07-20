import type { InputHTMLAttributes } from 'react'
import { forwardRef } from 'react'
import { cn } from './cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  const { className, ...rest } = props
  return <input ref={ref} {...rest} className={cn('ui-input', className)} />
})


