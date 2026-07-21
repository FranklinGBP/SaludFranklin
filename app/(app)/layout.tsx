import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";
import NutritionPlanTools from "@/components/NutritionPlanTools";

const NAV_ITEMS = [
  { href: "/dashboard", icon: "📊", label: "Dashboard" },
  { href: "/registro", icon: "🎙️", label: "Registro" },
  { href: "/fotos", icon: "📷", label: "Fotos" },
  { href: "/nutricion", icon: "🥗", label: "Nutrición" },
  { href: "/revision", icon: "🤖", label: "Revisión" },
  { href: "/plan", icon: "📆", label: "Entreno" },
  { href: "/ejercicios", icon: "🏋️", label: "Ejercicios" },
  { href: "/historial", icon: "📅", label: "Historial" },
];

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

      <main>
        <NutritionPlanTools />
        {children}
      </main>

      <nav className="fixed inset-x-0 bottom-0 overflow-x-auto border-t border-slate-200 bg-white">
        <div className="mx-auto flex min-w-max max-w-3xl gap-1 px-2 py-2 text-xs">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-w-20 flex-col items-center gap-1 px-2 py-1 text-slate-600 hover:text-emerald-600"
            >
              <span className="text-xl">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
