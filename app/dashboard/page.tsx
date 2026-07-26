import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Dashboard from "./Dashboard";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  const userId = (session.user as any).id as string;
  const entries = await prisma.entry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { payments: true, debtPayments: { orderBy: { paidAt: "desc" } } },
  });
  return (
    <Dashboard
      initialEntries={entries.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
        payments: e.payments.map((p) => ({ month: p.month, fromBalance: p.fromBalance })),
        debtPayments: e.debtPayments.map((p) => ({
          id: p.id,
          amount: p.amount,
          kind: p.kind,
          note: p.note,
          paidAt: p.paidAt.toISOString(),
        })),
      }))}
      userEmail={session.user?.email ?? ""}
      userName={session.user?.name ?? null}
    />
  );
}
