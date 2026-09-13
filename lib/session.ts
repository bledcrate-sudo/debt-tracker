import { getServerSession } from "next-auth";
import { authOptions } from "./auth";

export async function currentUserId(): Promise<string | undefined> {
  const session = await getServerSession(authOptions);
  return session?.user?.id;
}
