import Button from './Button.jsx'

export default function PricingCard({ plan }) {
  return (
    <div
      className={`flex flex-col rounded-xl border bg-white p-6 ${
        plan.featured ? 'border-blue-600 shadow-lg' : 'border-slate-200'
      }`}
    >
      <h3 className="text-base font-semibold">{plan.name}</h3>
      <p className="mt-1 text-sm text-slate-500">{plan.blurb}</p>
      <p className="mt-4 text-3xl font-bold">
        {plan.price}
        <span className="text-sm font-normal text-slate-500"> /mo</span>
      </p>
      <ul className="mt-4 flex-1 space-y-2 text-sm text-slate-600">
        {plan.features.map((f) => (
          <li key={f}>· {f}</li>
        ))}
      </ul>
      <div className="mt-6">
        <Button variant={plan.featured ? 'primary' : 'ghost'}>
          Choose {plan.name}
        </Button>
      </div>
    </div>
  )
}
