export default function Button({ variant = 'primary', children, ...props }) {
  const styles =
    variant === 'primary'
      ? 'px-4 bg-blue-600 text-white hover:bg-blue-700'
      : 'px-6 border border-slate-300 text-blue-600 hover:bg-slate-100'
  return (
    <button
      className={`rounded-full py-2 text-sm font-medium transition-colors ${styles}`}
      {...props}
    >
      {children}
    </button>
  )
}
