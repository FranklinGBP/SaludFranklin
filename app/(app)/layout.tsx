import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24">
      <header className="flex items-center justify-between py-4">
        <Link href="/dashboard" className="text-lg font-bold">
          Franklin Fit Voice
        </Link>
        <LogoutButton />
      </header>

      <main>{children}</main>

      <nav className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl justify-around py-2 text-xs">
          <Link href="/dashboard" className="flex flex-col items-center gap-1 px-2 py-1 text-slate-600 hover:text-emerald-600">
            <span className="text-xl">📊</span>Dashboard
          </Link>
          <Link href="/registro" className="flex flex-col items-center gap-1 px-2 py-1 text-slate-600 hover:text-emerald-600">
            <span className="text-xl">🎙️</span>Registro
          </Link>
          <Link href="/fotos" className="flex flex-col items-center gap-1 px-2 py-1 text-slate-600 hover:text-emerald-600">
            <span className="text-xl">📷</span>Fotos
          </Link>
          <Link href="/revision" className="flex flex-col items-center gap-1 px-2 py-1 text-slate-600 hover:text-emerald-600">
            <span className="text-xl">🤖</span>Revisión
          </Link>
          <Link href="/historial" className="flex flex-col items-center gap-1 px-2 py-1 text-slate-600 hover:text-emerald-600">
            <span className="text-xl">📅</span>Historial
          </Link>
        </div>
      </nav>
    </div>
  );
}
