import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { RequestsService, RequestResponse } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';

@Controller('requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  // An optional `Idempotency-Key` header makes retried creates safe: the same key
  // returns the original request instead of reserving a second time.
  @Post()
  create(
    @Body() dto: CreateRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RequestResponse> {
    return this.requests.create(dto, idempotencyKey);
  }

  // Filtered list — e.g. ?status=RESERVED (approval queue), ?employeeId=EMP-001.
  @Get()
  list(@Query() query: ListRequestsDto): Promise<RequestResponse[]> {
    return this.requests.list(query);
  }

  @Get(':id')
  getById(@Param('id') id: string): Promise<RequestResponse> {
    return this.requests.getById(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string): Promise<RequestResponse> {
    return this.requests.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string): Promise<RequestResponse> {
    return this.requests.reject(id);
  }
}
