import { useState, type FormEvent } from "react";

export function TokenGate({ rejected, onToken }: { rejected: boolean; onToken(token: string): void }) {
  const [value, setValue] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() !== "") {
      onToken(value.trim());
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="wordmark text-[3rem] leading-none">dibs</h1>
      <p className="mt-4 text-[1.0625rem]">
        See which agent has dibs on which part of the repository, and decide the changes that need a person.
      </p>
      <form className="mt-8 space-y-3" onSubmit={submit}>
        <label className="block text-[0.9375rem] font-semibold" htmlFor="token">
          Admin token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          className="mono block w-full rounded border border-rule bg-paper px-3 py-2"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {rejected && (
          <p className="text-[0.875rem] text-signal" role="alert">
            That token was not accepted. It is the value of the Worker's ADMIN_TOKEN secret.
          </p>
        )}
        <button type="submit" className="rounded bg-ink px-4 py-2 text-[0.9375rem] font-semibold text-paper">
          Open the board
        </button>
      </form>
    </main>
  );
}
