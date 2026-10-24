import type { Metadata } from "next";

import { AuthFrame } from "@/components/auth-frame";
import { SignUpForm } from "@/components/signup-form";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <AuthFrame title="Create an account">
      <SignUpForm />
    </AuthFrame>
  );
}
