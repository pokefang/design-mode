import Button from './Button.jsx'

export default function Hero() {
  return (
    <section className="mx-auto max-w-3xl px-8 py-24 text-center">
      <h1 className="text-xl font-black tracking-tight text-slate-900">
        Notes that organize themselves
      </h1>
      <p className="mx-auto mt-5 max-w-xl text-lg text-slate-600">
        Write anything. Acme Notes files it, links it, and finds it again the
        moment you need it.
      </p>
      <div className="mt-8 flex items-center justify-center gap-3">
        <Button>Start free</Button>
        <Button variant="ghost">Watch the demo</Button>
      </div>
    </section>
  )
}
