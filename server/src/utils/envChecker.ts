const requiredEnvVars: string[] = [
    'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET',
    'RESET_TOKEN_SECRET',
];

export function checkEnvVars(): void {
    const missingVars: string[] = requiredEnvVars.filter((varName) => !process.env[varName]);
    if (!process.env.DATABASE_URL && !process.env.DB_URL) missingVars.push('DATABASE_URL');
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
}
