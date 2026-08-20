import Header from './components/Header.jsx'
import Hero from './components/Hero.jsx'
import PricingSection from './components/PricingSection.jsx'

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Header />
      <main>
        <Hero />
        <PricingSection />
      </main>
      <footer className="border-t border-slate-200 py-8 text-center text-sm text-slate-500">
        Built to be clicked on. Toggle Design Mode with Cmd+Shift+D.
      </footer>
    </div>
  )
}
