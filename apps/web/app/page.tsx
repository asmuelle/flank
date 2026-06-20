import { redirect } from 'next/navigation';

// The product lives behind auth; the authed shell redirects on to sign-in when there is no session.
export default function RootPage() {
  redirect('/authed');
}
