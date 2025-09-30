export const metadata = {
  title: "Analytics | Kazuki Finance",
};

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded border border-purple-200 bg-purple-50 p-4 text-sm text-purple-700">
        Analytics dashboards are in progress. Thank you for your patience!
      </div>
      <section className="rounded border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-neutral-900">Analytics (Preview)</h1>
        <p className="mt-2 text-sm text-neutral-600">
          We are preparing insights about receipt volume, spend distribution, and store-by-store performance.
          Check back soon or let us know the KPIs you would like to track.
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-neutral-600">
          <li>Daily/weekly receipt ingestion metrics</li>
          <li>Spend by payment method and store</li>
          <li>AI enhancement success rates</li>
        </ul>
      </section>
    </div>
  );
}
