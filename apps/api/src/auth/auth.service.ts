import { Injectable, Inject, ConflictException, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import * as bcrypt from 'bcrypt'
import * as schema from '../db/schema'
import { DRIZZLE } from '../db/db.module'
import { CreateUserDto } from './dto/create-user.dto'
import { LoginDto } from './dto/login.dto'

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
    private jwtService: JwtService,
  ) {}

  async register(dto: CreateUserDto) {
    const existing = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email),
    })
    if (existing) throw new ConflictException('Email already in use')

    const passwordHash = await bcrypt.hash(dto.password, 10)
    const [user] = await this.db
      .insert(schema.users)
      .values({ email: dto.email, passwordHash, name: dto.name })
      .returning()

    return { accessToken: this.signToken(user.id, user.email) }
  }

  async login(dto: LoginDto) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email),
    })
    if (!user) throw new UnauthorizedException('Invalid credentials')

    const valid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!valid) throw new UnauthorizedException('Invalid credentials')

    return { accessToken: this.signToken(user.id, user.email) }
  }

  async validateUser(email: string, password: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, email),
    })
    if (!user) return null

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) return null

    const { passwordHash: _, ...result } = user
    return result
  }

  private signToken(userId: string, email: string) {
    return this.jwtService.sign({ sub: userId, email })
  }
}
