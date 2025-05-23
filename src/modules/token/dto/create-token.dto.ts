import { IsArray, IsString } from "class-validator";

export class CreateTokenDto {
    @IsArray({ message: "Danh sách truyền lên phải là 1 mảng" })
    @IsString({ each: true, message: "Token phải là string" })
    tokens: string[]
}
