export default function Button({ variant = 'primary', children, ...props }) {
  const styles =
    variant === 'primary'
      ? 'bg-blue-600 text-white hover:bg-blue-700'
      : 'border border-slate-300 text-slate-700 hover:bg-slate-100'
  return (
    <button
      className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${styles}`}
      {...props}
    >
      {children}
    </button>
  )
}
