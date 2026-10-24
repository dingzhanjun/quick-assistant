import { AuthForm } from "./auth-form";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">Quick Assistant</h1>
        <p className="text-muted-foreground">AI phone ordering for your restaurant.</p>
      </div>
      <AuthForm />
    </main>
  );
}
