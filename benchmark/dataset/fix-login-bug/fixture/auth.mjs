export function authenticate(user, password) {
  return Boolean(user && (user.locked || password === user.password));
}
