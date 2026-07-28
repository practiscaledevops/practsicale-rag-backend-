import { redirect } from "next/navigation";

// Root sends straight to the dashboard. Middleware bounces unauthenticated
// visitors from /dashboard/* to /login.
export default function Home() {
  redirect("/dashboard");
}
