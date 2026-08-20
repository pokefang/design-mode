import PricingCard from './PricingCard.jsx'

const plans = [
  {
    name: 'Starter',
    price: '$0',
    blurb: 'For trying things out',
    features: ['100 notes', 'Basic search', '1 device'],
  },
  {
    name: 'Pro',
    price: '$12',
    blurb: 'For daily writers',
    featured: true,
    features: ['Unlimited notes', 'Smart linking', 'All devices', 'Version history'],
  },
  {
    name: 'Team',
    price: '$29',
    blurb: 'For small teams',
    features: ['Everything in Pro', 'Shared spaces', 'Admin controls'],
  },
]

export default function PricingSection() {
  return (
    <section id="pricing" className="mx-auto max-w-5xl px-8 pb-24">
      <h2 className="text-center text-3xl font-bold tracking-tight">Pricing</h2>
      <p className="mt-2 text-center text-slate-600">
        Three plans. No surprises.
      </p>
      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {plans.map((plan) => (
          <PricingCard key={plan.name} plan={plan} />
        ))}
      </div>
    </section>
  )
}
