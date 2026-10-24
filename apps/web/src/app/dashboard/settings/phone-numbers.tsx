export function PhoneNumbers({ numbers }: { numbers: string[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Calls to these numbers are answered by the voice agent using this restaurant&apos;s menu. They are set up by
        the platform team; contact support to add or change one.
      </p>
      <ul className="divide-y rounded-lg border">
        {numbers.length === 0 && <li className="p-4 text-sm text-muted-foreground">No numbers yet.</li>}
        {numbers.map((n) => (
          <li key={n} className="p-3 font-mono">
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}
