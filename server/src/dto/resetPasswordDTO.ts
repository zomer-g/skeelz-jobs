import { IsString, MinLength, MaxLength, Matches } from 'class-validator';

export class ResetPasswordDTO {
    @IsString({ message: 'Token must be a string.' })
    token: string;

    @IsString({ message: 'Password must be a string.' })
    @MinLength(8, { message: 'Password must be at least 8 characters long.' })
    @MaxLength(16, { message: 'Password must be at most 16 characters long.' })
    newPassword: string;

    constructor(token: string, newPassword: string) {
        this.token = token;
        this.newPassword = newPassword;
    }
}
