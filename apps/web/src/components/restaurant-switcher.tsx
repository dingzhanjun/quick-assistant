"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui/select";
import { authClient } from "@/lib/auth-client";

const NEW = "__new__";

export function RestaurantSwitcher(props: {
  current: string;
  restaurants: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onChange(value: string) {
    if (value === NEW) return router.push("/onboarding");
    startTransition(async () => {
      await authClient.organization.setActive({ organizationId: value });
      router.refresh();
    });
  }

  return (
    <Select
      ariaLabel="Restaurant"
      width="clamp(8rem, 40vw, 12rem)"
      value={props.current}
      disabled={pending}
      onChange={onChange}
      options={[...props.restaurants.map((r) => ({ label: r.name, value: r.id })), { label: "+ New restaurant…", value: NEW }]}
    />
  );
}
