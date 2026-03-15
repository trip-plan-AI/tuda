import {
  Controller,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { TripsService } from './trips.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';
import { IsUUID } from 'class-validator';

class CreateInvitationDto {
  @IsUUID() userId: string;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class InvitationsController {
  constructor(
    private invitationsService: InvitationsService,
    private tripsService: TripsService,
    private collabGateway: CollaborationGateway,
  ) {}

  /** POST /trips/:tripId/invitations — owner/editor sends invite */
  @Post('trips/:tripId/invitations')
  async create(
    @Param('tripId') tripId: string,
    @Body() dto: CreateInvitationDto,
    @Req() req: any,
  ) {
    const trip = await this.tripsService.findByIdWithAccess(tripId, req.user.id);
    if (trip.role === 'viewer') {
      throw new ForbiddenException('Only trip owner or editors can send invitations');
    }

    const invite = await this.invitationsService.create(
      tripId,
      req.user.id,
      dto.userId,
    );

    const inviterName = await this.invitationsService.getInviterName(req.user.id);

    // Notify invited user — trip does NOT appear in their list yet
    this.collabGateway.notifyInviteReceived(dto.userId, {
      tripId,
      tripTitle: trip.title,
      inviterName,
      invitationId: invite.id,
    });

    return invite;
  }

  /** POST /invitations/:id/accept — invited user accepts */
  @Post('invitations/:id/accept')
  async accept(@Param('id') id: string, @Req() req: any) {
    const { collaborator, trip } = await this.invitationsService.accept(
      id,
      req.user.id,
    );

    if (trip) {
      // Now send trip to the new collaborator's profile
      this.collabGateway.notifyTripShared(req.user.id, trip);
      // Notify trip members + owner directly that a new collaborator joined
      this.collabGateway.notifyCollaboratorAdded(trip.id, collaborator, trip.ownerId);
    }

    return { accepted: true, trip };
  }

  /** DELETE /invitations/:id — invited user declines */
  @Delete('invitations/:id')
  async decline(@Param('id') id: string, @Req() req: any) {
    return this.invitationsService.decline(id, req.user.id);
  }
}
