import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBankBalance } from "@/lib/bank-balance";
import Dashboard from "./Dashboard";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  const userId = session.user.id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currency: true, balanceAdjustment: true, debtSharePct: true },
  });
  const bank = await getBankBalance(userId);
  const budgetItems = await prisma.budgetItem.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, label: true, amount: true, keywords: true },
  });
  const entries = await prisma.entry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      payments: true,
      debtPayments: { orderBy: { paidAt: "desc" } },
      bankTransactions: { select: { institution: true, account: true }, take: 1 },
    },
  });
  return (
    <Dashboard
      initialEntries={entries.map(({ bankTransactions, ...e }) => ({
        ...e,
        source: bankTransactions[0] ?? null,
        createdAt: e.createdAt.toISOString(),
        sourceKind: e.sourceKind,
        debtEntryId: e.debtEntryId,
        payments: e.payments.map((p) => ({
          month: p.month,
          fromBalance: p.fromBalance,
          debtEntryId: p.debtEntryId,
        })),
        debtPayments: e.debtPayments.map((p) => ({
          id: p.id,
          amount: p.amount,
          kind: p.kind,
          fromBalance: p.fromBalance,
          note: p.note,
          paidAt: p.paidAt.toISOString(),
        })),
      }))}
      userEmail={session.user?.email ?? ""}
      userName={session.user?.name ?? null}
      userCurrency={user?.currency ?? "USD"}
      userBalanceAdjustment={user?.balanceAdjustment ?? 0}
      initialBank={bank}
      initialBudgetItems={budgetItems}
      userDebtSharePct={user?.debtSharePct ?? 50}
    />
  );
}
