export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      access_requests: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          email: string
          granted_role: string | null
          id: string
          kind: string
          organization_id: string | null
          organization_name: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          email: string
          granted_role?: string | null
          id?: string
          kind: string
          organization_id?: string | null
          organization_name: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          email?: string
          granted_role?: string | null
          id?: string
          kind?: string
          organization_id?: string | null
          organization_name?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "access_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      approvals: {
        Row: {
          args: Json
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          note: string | null
          run_id: string
          status: string
          tool_call_id: string
          tool_name: string
        }
        Insert: {
          args?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          note?: string | null
          run_id: string
          status?: string
          tool_call_id: string
          tool_name: string
        }
        Update: {
          args?: Json
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          note?: string | null
          run_id?: string
          status?: string
          tool_call_id?: string
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor: string | null
          created_at: string
          detail: Json
          id: number
          organization_id: string | null
        }
        Insert: {
          action: string
          actor?: string | null
          created_at?: string
          detail?: Json
          id?: never
          organization_id?: string | null
        }
        Update: {
          action?: string
          actor?: string | null
          created_at?: string
          detail?: Json
          id?: never
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      case_file_blocks: {
        Row: {
          created_at: string
          file_id: string
          id: number
          image_path: string | null
          kind: string
          label: string
          media_type: string | null
          organization_id: string
          page: number | null
          parser: string
          seq: number
          text: string | null
        }
        Insert: {
          created_at?: string
          file_id: string
          id?: never
          image_path?: string | null
          kind: string
          label?: string
          media_type?: string | null
          organization_id: string
          page?: number | null
          parser: string
          seq: number
          text?: string | null
        }
        Update: {
          created_at?: string
          file_id?: string
          id?: never
          image_path?: string | null
          kind?: string
          label?: string
          media_type?: string | null
          organization_id?: string
          page?: number | null
          parser?: string
          seq?: number
          text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "case_file_blocks_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "case_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_file_blocks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      case_files: {
        Row: {
          bytes: number
          case_id: string
          created_at: string
          created_by: string | null
          error: string | null
          filename: string
          format: string
          id: string
          media_type: string | null
          notes: Json
          organization_id: string
          pages: number | null
          parsed_at: string | null
          position: number
          sha256: string | null
          status: string
          storage_path: string
          updated_at: string
        }
        Insert: {
          bytes: number
          case_id: string
          created_at?: string
          created_by?: string | null
          error?: string | null
          filename: string
          format: string
          id?: string
          media_type?: string | null
          notes?: Json
          organization_id: string
          pages?: number | null
          parsed_at?: string | null
          position?: number
          sha256?: string | null
          status?: string
          storage_path: string
          updated_at?: string
        }
        Update: {
          bytes?: number
          case_id?: string
          created_at?: string
          created_by?: string | null
          error?: string | null
          filename?: string
          format?: string
          id?: string
          media_type?: string | null
          notes?: Json
          organization_id?: string
          pages?: number | null
          parsed_at?: string | null
          position?: number
          sha256?: string | null
          status?: string
          storage_path?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_files_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      cases: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          kind: string
          name: string
          organization_id: string
          project_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          name: string
          organization_id: string
          project_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          name?: string
          organization_id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cases_project_id_organization_id_fkey"
            columns: ["project_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      certivity_reference: {
        Row: {
          case_id: string
          certivity_commit: string
          content: Json
          kind: string
          loaded_at: string
        }
        Insert: {
          case_id?: string
          certivity_commit: string
          content: Json
          kind: string
          loaded_at?: string
        }
        Update: {
          case_id?: string
          certivity_commit?: string
          content?: Json
          kind?: string
          loaded_at?: string
        }
        Relationships: []
      }
      memberships: {
        Row: {
          created_at: string
          organization_id: string
          role: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      model_usage: {
        Row: {
          cache_read_tokens: number
          cache_write_tokens: number
          case_id: string | null
          cost_usd: number | null
          created_at: string
          id: number
          input_tokens: number
          key_hint: string | null
          key_source: string
          model: string
          organization_id: string
          output_tokens: number
          process: string
          provider: string
          requests: number
          run_id: string | null
          unpriced_requests: number
        }
        Insert: {
          cache_read_tokens?: number
          cache_write_tokens?: number
          case_id?: string | null
          cost_usd?: number | null
          created_at?: string
          id?: never
          input_tokens?: number
          key_hint?: string | null
          key_source: string
          model: string
          organization_id: string
          output_tokens?: number
          process: string
          provider: string
          requests?: number
          run_id?: string | null
          unpriced_requests?: number
        }
        Update: {
          cache_read_tokens?: number
          cache_write_tokens?: number
          case_id?: string | null
          cost_usd?: number | null
          created_at?: string
          id?: never
          input_tokens?: number
          key_hint?: string | null
          key_source?: string
          model?: string
          organization_id?: string
          output_tokens?: number
          process?: string
          provider?: string
          requests?: number
          run_id?: string | null
          unpriced_requests?: number
        }
        Relationships: [
          {
            foreignKeyName: "model_usage_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "model_usage_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "model_usage_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_models: {
        Row: {
          model: string
          organization_id: string
          process: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          model: string
          organization_id: string
          process: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          model?: string
          organization_id?: string
          process?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_models_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_settings: {
        Row: {
          max_model_requests: number | null
          model: string | null
          monthly_cost_cap_usd: number | null
          organization_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          max_model_requests?: number | null
          model?: string | null
          monthly_cost_cap_usd?: number | null
          organization_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          max_model_requests?: number | null
          model?: string | null
          monthly_cost_cap_usd?: number | null
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      project_regulations: {
        Row: {
          created_at: string
          created_by: string | null
          organization_id: string
          project_id: string
          regulation_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          organization_id: string
          project_id: string
          regulation_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          organization_id?: string
          project_id?: string
          regulation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_regulations_project_id_organization_id_fkey"
            columns: ["project_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "project_regulations_regulation_id_fkey"
            columns: ["regulation_id"]
            isOneToOne: false
            referencedRelation: "regulations"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          all_regulations: boolean
          created_at: string
          created_by: string | null
          id: string
          name: string
          organization_id: string
        }
        Insert: {
          all_regulations?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          organization_id: string
        }
        Update: {
          all_regulations?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_connections: {
        Row: {
          auth_scheme: string | null
          auth_username: string | null
          base_url: string | null
          created_at: string
          created_by: string | null
          last4: string
          organization_id: string
          provider: string
          secret_id: string | null
          source: string
        }
        Insert: {
          auth_scheme?: string | null
          auth_username?: string | null
          base_url?: string | null
          created_at?: string
          created_by?: string | null
          last4: string
          organization_id: string
          provider: string
          secret_id?: string | null
          source?: string
        }
        Update: {
          auth_scheme?: string | null
          auth_username?: string | null
          base_url?: string | null
          created_at?: string
          created_by?: string | null
          last4?: string
          organization_id?: string
          provider?: string
          secret_id?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_connections_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_embeddings: {
        Row: {
          created_at: string
          embedding: unknown
          input_sha256: string
          model: string
          organization_id: string
        }
        Insert: {
          created_at?: string
          embedding: unknown
          input_sha256: string
          model: string
          organization_id: string
        }
        Update: {
          created_at?: string
          embedding?: unknown
          input_sha256?: string
          model?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulation_embeddings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_figure_descriptions: {
        Row: {
          described_at: string
          description: string | null
          error: string | null
          image_sha256: string
          model: string
          organization_id: string
        }
        Insert: {
          described_at?: string
          description?: string | null
          error?: string | null
          image_sha256: string
          model: string
          organization_id: string
        }
        Update: {
          described_at?: string
          description?: string | null
          error?: string | null
          image_sha256?: string
          model?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulation_figure_descriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_figures: {
        Row: {
          height_pt: number
          image_sha256: string
          organization_id: string
          page: number
          position: number
          version_id: string
          width_pt: number
        }
        Insert: {
          height_pt: number
          image_sha256: string
          organization_id: string
          page: number
          position: number
          version_id: string
          width_pt: number
        }
        Update: {
          height_pt?: number
          image_sha256?: string
          organization_id?: string
          page?: number
          position?: number
          version_id?: string
          width_pt?: number
        }
        Relationships: [
          {
            foreignKeyName: "regulation_figures_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "regulation_figures_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "regulation_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_import_files: {
        Row: {
          error: string | null
          file_name: string
          import_id: string
          position: number
          regulation_code: string
          regulation_title: string | null
          role: string | null
          sha256: string
          size_bytes: number | null
          source_url: string | null
          status: string
          updated_at: string
          url: string
          version_label: string
          version_status: string | null
          version_title: string | null
        }
        Insert: {
          error?: string | null
          file_name: string
          import_id: string
          position: number
          regulation_code: string
          regulation_title?: string | null
          role?: string | null
          sha256: string
          size_bytes?: number | null
          source_url?: string | null
          status?: string
          updated_at?: string
          url: string
          version_label: string
          version_status?: string | null
          version_title?: string | null
        }
        Update: {
          error?: string | null
          file_name?: string
          import_id?: string
          position?: number
          regulation_code?: string
          regulation_title?: string | null
          role?: string | null
          sha256?: string
          size_bytes?: number | null
          source_url?: string | null
          status?: string
          updated_at?: string
          url?: string
          version_label?: string
          version_status?: string | null
          version_title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "regulation_import_files_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "regulation_imports"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_imports: {
        Row: {
          created_at: string
          created_by: string | null
          error: string | null
          finished_at: string | null
          id: string
          index: Json
          organization_id: string
          source_name: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          index: Json
          organization_id: string
          source_name: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          index?: Json
          organization_id?: string
          source_name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulation_imports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_paragraph_keys: {
        Row: {
          input_sha256: string
          organization_id: string
          paragraph_id: string
        }
        Insert: {
          input_sha256: string
          organization_id: string
          paragraph_id: string
        }
        Update: {
          input_sha256?: string
          organization_id?: string
          paragraph_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulation_paragraph_keys_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "regulation_paragraph_keys_paragraph_id_fkey"
            columns: ["paragraph_id"]
            isOneToOne: true
            referencedRelation: "regulation_paragraphs"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_paragraphs: {
        Row: {
          annex: string | null
          appendix: string | null
          content_hash: string
          context: string | null
          created_at: string
          fts: unknown
          heading: string
          id: string
          kind: string
          label: string | null
          number: string | null
          organization_id: string
          page_end: number
          page_start: number
          part: string | null
          position: number
          superseded_at: string | null
          text: string
          version_id: string
        }
        Insert: {
          annex?: string | null
          appendix?: string | null
          content_hash: string
          context?: string | null
          created_at?: string
          fts?: unknown
          heading?: string
          id?: string
          kind: string
          label?: string | null
          number?: string | null
          organization_id: string
          page_end: number
          page_start: number
          part?: string | null
          position: number
          superseded_at?: string | null
          text: string
          version_id: string
        }
        Update: {
          annex?: string | null
          appendix?: string | null
          content_hash?: string
          context?: string | null
          created_at?: string
          fts?: unknown
          heading?: string
          id?: string
          kind?: string
          label?: string | null
          number?: string | null
          organization_id?: string
          page_end?: number
          page_start?: number
          part?: string | null
          position?: number
          superseded_at?: string | null
          text?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulation_paragraphs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "regulation_paragraphs_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "regulation_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      regulation_versions: {
        Row: {
          created_at: string
          extracted_at: string | null
          extracted_with: string | null
          extraction_error: string | null
          figures_missing: number
          file_name: string
          id: string
          last_import_id: string | null
          md_path: string | null
          organization_id: string
          page_count: number | null
          paragraph_count: number | null
          pdf_path: string
          regulation_id: string
          role: string | null
          scope_keywords: string[] | null
          scope_summary: string | null
          sha256: string
          size_bytes: number
          status: string | null
          summarized_at: string | null
          summary_model: string | null
          summary_sha256: string | null
          title: string | null
          updated_at: string
          version_label: string
        }
        Insert: {
          created_at?: string
          extracted_at?: string | null
          extracted_with?: string | null
          extraction_error?: string | null
          figures_missing?: number
          file_name: string
          id?: string
          last_import_id?: string | null
          md_path?: string | null
          organization_id: string
          page_count?: number | null
          paragraph_count?: number | null
          pdf_path: string
          regulation_id: string
          role?: string | null
          scope_keywords?: string[] | null
          scope_summary?: string | null
          sha256: string
          size_bytes: number
          status?: string | null
          summarized_at?: string | null
          summary_model?: string | null
          summary_sha256?: string | null
          title?: string | null
          updated_at?: string
          version_label: string
        }
        Update: {
          created_at?: string
          extracted_at?: string | null
          extracted_with?: string | null
          extraction_error?: string | null
          figures_missing?: number
          file_name?: string
          id?: string
          last_import_id?: string | null
          md_path?: string | null
          organization_id?: string
          page_count?: number | null
          paragraph_count?: number | null
          pdf_path?: string
          regulation_id?: string
          role?: string | null
          scope_keywords?: string[] | null
          scope_summary?: string | null
          sha256?: string
          size_bytes?: number
          status?: string | null
          summarized_at?: string | null
          summary_model?: string | null
          summary_sha256?: string | null
          title?: string | null
          updated_at?: string
          version_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulation_versions_last_import_id_fkey"
            columns: ["last_import_id"]
            isOneToOne: false
            referencedRelation: "regulation_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "regulation_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "regulation_versions_regulation_id_fkey"
            columns: ["regulation_id"]
            isOneToOne: false
            referencedRelation: "regulations"
            referencedColumns: ["id"]
          },
        ]
      }
      regulations: {
        Row: {
          code: string
          created_at: string
          id: string
          kind: string
          organization_id: string
          slug: string
          source_url: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          kind: string
          organization_id: string
          slug: string
          source_url?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string
          slug?: string
          source_url?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "regulations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      requirements: {
        Row: {
          case_id: string
          created_at: string
          ext_id: string
          findings: Json
          id: string
          organization_id: string
          page: number
          paragraph: string | null
          paragraph_hash: string
          paragraph_id: string | null
          paragraph_superseded_at: string | null
          regulation: string
          run_id: string
          status: string
          test_case: string | null
          text: string
          updated_at: string
          version_id: string | null
          version_label: string
        }
        Insert: {
          case_id: string
          created_at?: string
          ext_id: string
          findings?: Json
          id?: string
          organization_id: string
          page: number
          paragraph?: string | null
          paragraph_hash: string
          paragraph_id?: string | null
          paragraph_superseded_at?: string | null
          regulation: string
          run_id: string
          status?: string
          test_case?: string | null
          text: string
          updated_at?: string
          version_id?: string | null
          version_label: string
        }
        Update: {
          case_id?: string
          created_at?: string
          ext_id?: string
          findings?: Json
          id?: string
          organization_id?: string
          page?: number
          paragraph?: string | null
          paragraph_hash?: string
          paragraph_id?: string | null
          paragraph_superseded_at?: string | null
          regulation?: string
          run_id?: string
          status?: string
          test_case?: string | null
          text?: string
          updated_at?: string
          version_id?: string | null
          version_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "requirements_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "requirements_paragraph_id_fkey"
            columns: ["paragraph_id"]
            isOneToOne: false
            referencedRelation: "regulation_paragraphs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirements_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirements_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "regulation_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      run_checks: {
        Row: {
          agent_version: string | null
          certivity_commit: string
          checked_at: string
          result: Json
          run_id: string
          source: string
          submission_sha256: string
        }
        Insert: {
          agent_version?: string | null
          certivity_commit: string
          checked_at?: string
          result: Json
          run_id: string
          source: string
          submission_sha256: string
        }
        Update: {
          agent_version?: string | null
          certivity_commit?: string
          checked_at?: string
          result?: Json
          run_id?: string
          source?: string
          submission_sha256?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_checks_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_events: {
        Row: {
          created_at: string
          id: number
          kind: string
          payload: Json
          run_id: string
        }
        Insert: {
          created_at?: string
          id?: never
          kind: string
          payload?: Json
          run_id: string
        }
        Update: {
          created_at?: string
          id?: never
          kind?: string
          payload?: Json
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_files: {
        Row: {
          bytes: number
          created_at: string
          filename: string
          format: string
          id: string
          media_type: string | null
          organization_id: string
          run_id: string
          sha256: string | null
          storage_path: string
        }
        Insert: {
          bytes: number
          created_at?: string
          filename: string
          format: string
          id?: string
          media_type?: string | null
          organization_id: string
          run_id: string
          sha256?: string | null
          storage_path: string
        }
        Update: {
          bytes?: number
          created_at?: string
          filename?: string
          format?: string
          id?: string
          media_type?: string | null
          organization_id?: string
          run_id?: string
          sha256?: string | null
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_files_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_files_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_state: {
        Row: {
          conversation: Json
          run_id: string
          updated_at: string
        }
        Insert: {
          conversation: Json
          run_id: string
          updated_at?: string
        }
        Update: {
          conversation?: Json
          run_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_state_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          agent_version: string | null
          case_id: string | null
          created_at: string
          created_by: string
          error: string | null
          id: string
          model: string | null
          organization_id: string
          output: string | null
          requested_model: string | null
          status: string
          task: string
          updated_at: string
          usage: Json
        }
        Insert: {
          agent_version?: string | null
          case_id?: string | null
          created_at?: string
          created_by?: string
          error?: string | null
          id?: string
          model?: string | null
          organization_id: string
          output?: string | null
          requested_model?: string | null
          status?: string
          task: string
          updated_at?: string
          usage?: Json
        }
        Update: {
          agent_version?: string | null
          case_id?: string | null
          created_at?: string
          created_by?: string
          error?: string | null
          id?: string
          model?: string | null
          organization_id?: string
          output?: string | null
          requested_model?: string | null
          status?: string
          task?: string
          updated_at?: string
          usage?: Json
        }
        Relationships: [
          {
            foreignKeyName: "runs_case_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_member_by_email: {
        Args: { member_email: string; member_role: string; org: string }
        Returns: string
      }
      add_regulation_embedding_keys: {
        Args: { p_limit?: number; p_organization_id: string }
        Returns: number
      }
      analyze_regulation_search: { Args: never; Returns: undefined }
      bootstrap_member: {
        Args: {
          make_platform_admin: boolean
          member: string
          member_role: string
        }
        Returns: string
      }
      can_reset_password: { Args: { member: string }; Returns: boolean }
      cancel_access_request: { Args: { request: string }; Returns: undefined }
      cancel_regulation_import: { Args: { job: string }; Returns: undefined }
      create_organization: { Args: { org_name: string }; Returns: string }
      create_organization_with_admin: {
        Args: { admin_email?: string; org_name: string }
        Returns: string
      }
      create_regulation_import: {
        Args: { org: string; regulation_index: Json; source_name: string }
        Returns: string
      }
      decide_access_request: {
        Args: { approve: boolean; member_role?: string; request: string }
        Returns: string
      }
      delete_provider_key: {
        Args: { key_provider: string; org: string }
        Returns: undefined
      }
      delete_regulations: {
        Args: { org: string; regulation_ids: string[] }
        Returns: Json
      }
      find_people: {
        Args: { org: string; search: string }
        Returns: {
          email: string
          role: string
          status: string
          user_id: string
        }[]
      }
      joinable_organizations: {
        Args: never
        Returns: {
          id: string
          name: string
        }[]
      }
      match_regulation_paragraphs: {
        Args: {
          p_candidates?: number
          p_k?: number
          p_model: string
          p_organization_id: string
          p_query: string
          p_query_embedding: unknown
          p_version_ids?: string[]
        }
        Returns: {
          heading: string
          kind: string
          label: string
          page_end: number
          page_start: number
          paragraph_id: string
          regulation_code: string
          role: string
          score: number
          similarity: number
          text: string
          text_rank: number
          vector_rank: number
          version_id: string
          version_label: string
        }[]
      }
      my_access: { Args: never; Returns: Json }
      organization_month_cost: { Args: { org: string }; Returns: number }
      organization_people: {
        Args: { org: string }
        Returns: {
          email: string
          last_sign_in_at: string
          role: string
          status: string
          user_id: string
        }[]
      }
      organization_usage: {
        Args: { months?: number; org: string }
        Returns: {
          cost_usd: number
          month: string
          runs: number
          tokens: number
        }[]
      }
      organization_usage_breakdown: {
        Args: { org: string; since: string }
        Returns: {
          cache_read_tokens: number
          cache_write_tokens: number
          cost_usd: number
          input_tokens: number
          key_hint: string
          key_source: string
          model: string
          output_tokens: number
          process: string
          provider: string
          requests: number
          runs: number
          unpriced_requests: number
        }[]
      }
      organization_usage_series: {
        Args: { bucket?: string; org: string; since: string }
        Returns: {
          cost_usd: number
          input_tokens: number
          output_tokens: number
          period: string
          provider: string
        }[]
      }
      prune_regulation_embeddings: {
        Args: { p_model: string; p_organization_id: string }
        Returns: number
      }
      read_provider_endpoint: {
        Args: { key_provider: string; org: string }
        Returns: Json
      }
      read_provider_key: {
        Args: { key_provider: string; org: string }
        Returns: string
      }
      record_deployment_change: {
        Args: { change: string; detail: Json }
        Returns: undefined
      }
      record_regulation_extraction_failure: {
        Args: {
          p_error: string
          p_extracted_with: string
          p_sha256: string
          p_version_id: string
        }
        Returns: undefined
      }
      record_regulation_version: {
        Args: {
          p_code: string
          p_file_name: string
          p_import_id: string
          p_kind: string
          p_organization_id: string
          p_pdf_path: string
          p_role: string
          p_sha256: string
          p_size_bytes: number
          p_slug: string
          p_source_url: string
          p_status: string
          p_title: string
          p_version_label: string
          p_version_title: string
        }
        Returns: string
      }
      refresh_regulation_embedding_keys: {
        Args: { p_organization_id: string }
        Returns: number
      }
      regulation_citation_counts: {
        Args: { org: string }
        Returns: {
          regulation_id: string
          requirements: number
        }[]
      }
      regulation_embedding_input: {
        Args: {
          body: string
          code: string
          context: string
          heading: string
          title: string
        }
        Returns: string
      }
      regulation_embedding_key: {
        Args: {
          body: string
          code: string
          context: string
          heading: string
          title: string
        }
        Returns: string
      }
      regulation_index_status: {
        Args: { org: string }
        Returns: {
          keyed: number
          last_embedded_at: string
          paragraphs: number
          vectors: Json
          version_id: string
        }[]
      }
      regulation_texts_to_embed: {
        Args: { p_limit?: number; p_model: string; p_organization_id: string }
        Returns: {
          input: string
          input_sha256: string
        }[]
      }
      remove_member: {
        Args: { member: string; org: string }
        Returns: undefined
      }
      rename_organization: {
        Args: { new_name: string; org: string }
        Returns: undefined
      }
      replace_regulation_figures: {
        Args: {
          p_figures: Json
          p_missing: number
          p_sha256: string
          p_version_id: string
        }
        Returns: number
      }
      replace_regulation_paragraphs: {
        Args: {
          p_extracted_with: string
          p_page_count: number
          p_paragraphs: Json
          p_sha256: string
          p_version_id: string
        }
        Returns: number
      }
      request_organization: { Args: { org_name: string }; Returns: string }
      request_to_join: { Args: { org: string }; Returns: string }
      set_member: {
        Args: {
          member: string
          member_role: string
          member_status?: string
          org: string
        }
        Returns: undefined
      }
      set_organization_model: {
        Args: { model_process: string; new_model: string; org: string }
        Returns: undefined
      }
      set_provider_endpoint: {
        Args: {
          endpoint_auth: string
          endpoint_secret?: string
          endpoint_url: string
          endpoint_username?: string
          key_provider: string
          org: string
        }
        Returns: undefined
      }
      set_provider_key: {
        Args: {
          api_key: string
          key_provider: string
          key_source?: string
          org: string
        }
        Returns: undefined
      }
      start_run: {
        Args: { p_files?: Json; p_organization_id: string; p_task: string }
        Returns: string
      }
      update_organization_settings: {
        Args: {
          new_max_model_requests: number
          new_model: string
          new_monthly_cost_cap_usd: number
          org: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
