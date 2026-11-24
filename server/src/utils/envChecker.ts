const requiredEnvVars: string[] = [
    'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET',
    'RESET_TOKEN_SECRET',
];

export const MIN_JWT_SECRET_LENGTH = 32;

/** Problems with the three JWT secrets: each at least 32 characters, and all three different. */
export const jwtSecretProblems = (env: Record<string, string | undefined> = process.env): string[] => {
    const problems: string[] = [];
    for (const k of requiredEnvVars) {
        const v = env[k] ?? '';
        if (v && v.length < MIN_JWT_SECRET_LENGTH) problems.push(`${k} is shorter than ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    const values = requiredEnvVars.map((k) => env[k] ?? '').filter(Boolean);
    if (new Set(values).size !== values.length) problems.push('the three JWT secrets must all be different');
    return problems;
};

export function checkEnvVars(): void {
    const missingVars: string[] = requiredEnvVars.filter((varName) => !process.env[varName]);
    if (!process.env.DATABASE_URL && !process.env.DB_URL) missingVars.push('DATABASE_URL');
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    // Weak or shared secrets: loud at every boot. The server refuses to start only with STRICT_SECRETS=true, so a
    // deploy never goes down over a value nobody has checked yet (turn it on once the prod secrets are verified).
    const problems = jwtSecretProblems();
    if (problems.length) {
        const text = `[env] JWT secrets: ${problems.join('; ')}`;
        if (process.env.STRICT_SECRETS === 'true') throw new Error(text);
        console.error(`${text} — set new values (sessions and reset links made with the old ones stop working)`);
    }
}
