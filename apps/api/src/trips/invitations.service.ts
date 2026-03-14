import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE } from '../db/db.module';
import * as schema from '../db/schema';
import { CollaboratorsService } from './collaborators.service';

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
    private collaboratorsService: CollaboratorsService,
  ) {}

  async create(tripId: string, inviterId: string, invitedUserId: string) {
    // Check not already a collaborator
    const existing = await this.db.query.tripCollaborators.findFirst({
      where: and(
        eq(schema.tripCollaborators.tripId, tripId),
        eq(schema.tripCollaborators.userId, invitedUserId),
      ),
    });
    if (existing) throw new ConflictException('User is already a collaborator');

    // Upsert: if invite already exists just return it
    const existingInvite = await this.db.query.invitations.findFirst({
      where: and(
        eq(schema.invitations.tripId, tripId),
        eq(schema.invitations.invitedUserId, invitedUserId),
      ),
    });
    if (existingInvite) return existingInvite;

    const [invite] = await this.db
      .insert(schema.invitations)
      .values({ tripId, inviterId, invitedUserId })
      .returning();
    return invite;
  }

  /** Accept: add to trip_collaborators, delete invitation */
  async accept(invitationId: string, userId: string) {
    const invite = await this.db.query.invitations.findFirst({
      where: eq(schema.invitations.id, invitationId),
    });
    if (!invite) throw new NotFoundException('Invitation not found');
    if (invite.invitedUserId !== userId)
      throw new ForbiddenException('Not your invitation');

    // Add as collaborator
    const collaborator = await this.collaboratorsService.add(
      invite.tripId,
      userId,
      'editor',
    );

    // Delete the invitation
    await this.db
      .delete(schema.invitations)
      .where(eq(schema.invitations.id, invitationId));

    // Return trip data for the frontend
    const trip = await this.db.query.trips.findFirst({
      where: eq(schema.trips.id, invite.tripId),
      with: { points: { orderBy: [schema.routePoints.order] } },
    });

    return { collaborator, trip };
  }

  /** Decline: delete invitation without adding to collaborators */
  async decline(invitationId: string, userId: string) {
    const invite = await this.db.query.invitations.findFirst({
      where: eq(schema.invitations.id, invitationId),
    });
    if (!invite) throw new NotFoundException('Invitation not found');
    if (invite.invitedUserId !== userId)
      throw new ForbiddenException('Not your invitation');

    await this.db
      .delete(schema.invitations)
      .where(eq(schema.invitations.id, invitationId));

    return { declined: true };
  }

  async getInviterName(inviterId: string): Promise<string> {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, inviterId),
    });
    return user?.name ?? user?.email ?? 'Пользователь';
  }
}
