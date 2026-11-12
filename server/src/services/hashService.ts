// bcryptjs: same hash format as the native module, no compiler needed at build.
import bcrypt from 'bcryptjs';

// Hash a password with bcrypt
export const hashPassword = async (password: string): Promise<string> => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

// Compare a given password with the hashed password
export const comparePassword = async (inputPassword: string, hashedPassword: string): Promise<boolean> => {
  return await bcrypt.compare(inputPassword, hashedPassword);
};