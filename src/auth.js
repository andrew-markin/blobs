import jwt from 'jsonwebtoken'

const SECRET = process.env.TOKEN_SECRET

// Never fall back to a well-known secret, as anyone could sign tokens with it
if (!SECRET) {
  console.error('TOKEN_SECRET environment variable is not set')
  process.exit(1)
}

export const getToken = (bucket) => {
  return jwt.sign({ bucket }, SECRET)
}

export const getBucket = (token) => {
  try {
    return jwt.verify(token, SECRET).bucket
  } catch {
    // Nothing
  }
}
