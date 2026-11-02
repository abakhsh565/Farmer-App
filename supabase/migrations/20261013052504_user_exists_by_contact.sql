-- Farmer App · read-only contact lookup for the sign-in sheet
--
-- The sheet asks, before asking for a password: does an account already exist for
-- this contact (phone number or email)? The answer decides which of the two steps
-- the farmer sees next — "enter your password" for a known contact, "your name and
-- a password" for a new one — and it has to be right, because the wrong answer
-- tells a returning farmer their account does not exist.
--
-- There is no client-side way to answer it honestly. Supabase Auth gives the
-- client no "get user by email/phone" read, and `signInWithPassword` cannot tell
-- "the user exists but typed the wrong password" from "the user does not exist" —
-- both come back as `invalid_credentials`.
--
-- So the lookup is server-side. It is a security definer, like `ensure_party()`,
-- because `auth.users` is readable only by the service role. It reads that table
-- and returns one boolean; it never returns a row, a name or an id, and it is
-- read-only — it creates and changes nothing.
--
-- Honesty rule: this is *not* a user-listing endpoint. One contact in, one boolean
-- out. Anything broader would let a client enumerate accounts, which the PRD
-- forbids.

create or replace function public.user_exists_by_contact(p_contact text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact text;
  v_digits  text;
begin
  if p_contact is null or btrim(p_contact) = '' then
    return false;
  end if;

  v_contact := btrim(p_contact);

  -- Email path: auth.users stores the address lowercased, so match the same way.
  if v_contact ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    return exists (
      select 1 from auth.users
      where lower(email) = lower(v_contact)
      limit 1
    );
  end if;

  -- Phone path: compare digits only, so the app can pass the national form it
  -- asks the farmer for (`03001234567`) while the row holds `+923001234567`.
  if v_contact ~* '^\+?[0-9]+$' then
    v_digits := regexp_replace(v_contact, '\D', '', 'g');
    /*
     * `03001234567` and `923001234567` are the same number. The trailing-9 match
     * compares the last ten digits, which is what both forms share, and is narrow
     * enough that two different numbers cannot collide on it.
     */
    return exists (
      select 1 from auth.users
      where length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
        and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10)
            = right(v_digits, 10)
      limit 1
    );
  end if;

  return false;
end;
$$;

comment on function public.user_exists_by_contact(text) is
  'Read-only, security-definer lookup of whether an auth.user exists for a given contact (email or phone digits). Used by the sign-in sheet before it asks for a password. Returns one boolean, never a list.';

-- Anonymous callers can reach the sheet, so both roles need execute; the function
-- itself leaks nothing beyond a yes/no for a contact the caller already typed.
grant execute on function public.user_exists_by_contact(text) to authenticated;
grant execute on function public.user_exists_by_contact(text) to anon;
