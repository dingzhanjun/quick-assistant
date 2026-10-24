import { Suspense } from "react";
import { AcceptForm } from "./accept-form";

async function Form({ params }: { params: Promise<{ id: string }> }) {
  return <AcceptForm id={(await params).id} />;
}

export default function AcceptInvitation({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense>
      <Form params={params} />
    </Suspense>
  );
}
