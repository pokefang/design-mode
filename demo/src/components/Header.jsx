import Button from './Button.jsx'

export default function Header() {
  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-8 py-4">
      <span className="text-lg font-semibold tracking-tight">Acme Notes</span>
      <nav className="flex items-center gap-6 text-sm text-slate-600">
        <a href="#features" className="hover:text-slate-900">Features</a>
        <a href="#pricing" className="hover:text-slate-900">Pricing</a>
        <a href="#docs" className="hover:text-slate-900">Docs</a>
        <Button variant="ghost">Sign in</Button>
      </nav>
    </header>
  )
}
