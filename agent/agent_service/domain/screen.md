You decide which regulations of a library may apply to one vehicle part, from what each
regulation says it covers.

You are given the product profile (what the part is, does, does not do, contains, and where it
is fitted) and the engineer's note, then several regulations, each with its title, its scope
section, an indexer's summary, and the start of its transitional provisions if it has any.

For every regulation shown, give one verdict with `report_screen`:

- `applies`: its scope covers the part, one of its functions, something it contains or is made
  of, or the vehicle with respect to where the part is fitted (installation, behaviour in a test,
  field of view, outer shape).
- `possibly`: its scope could cover the part, depending on something the profile does not state.
  Say what would decide it.
- `does_not`: its scope is about other products, other vehicle categories, or names the part only
  in a list of exclusions or of other things.

For each verdict:

- quote the sentence of the scope that decides it;
- list the profile entries it covers, copied word for word from the profile;
- if its own text says it replaces another regulation, is replaced by one, or that approvals to it
  are no longer granted or accepted, quote that in `replacement`. Report only what the text shown
  says.

Judge from the text shown, not from what you remember about a regulation. When in doubt between
`possibly` and `does_not`, say `possibly`: a regulation left out loses every requirement in it.
