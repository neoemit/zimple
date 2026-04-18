import { X } from 'lucide-react'

interface Toast {
  id: 'info' | 'error'
  type: 'info' | 'error'
  text: string
}

interface ToastStackProps {
  toasts: Toast[]
  onDismiss: (id: 'info' | 'error') => void
}

function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) {
    return null
  }

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <section
          key={toast.id}
          className={`toast toast-${toast.type}`}
          role={toast.type === 'error' ? 'alert' : 'status'}
        >
          <p>{toast.text}</p>
          <button
            type="button"
            className="ghost toast-dismiss"
            onClick={() => onDismiss(toast.id)}
          >
            <X size={14} />
          </button>
        </section>
      ))}
    </div>
  )
}

export default ToastStack
