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
  });
  return (
    <Dashboard
      initialEntries={entries.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
      }))}
      userEmail={session.user?.email ?? ""}
      userName={session.user?.name ?? null}
    />
  );
}
